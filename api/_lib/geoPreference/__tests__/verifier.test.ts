import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Verifier tests — no network. The text-LLM router and the Anthropic SDK are
 * mocked so each provider path (DeepSeek ok, DeepSeek → Claude fallback, every
 * provider failing) is exercised deterministically. The rule under test above
 * all others: a check that did NOT run is `status:'error', overall:'unknown'`
 * — never 'agree'.
 */

const h = vi.hoisted(() => ({
  routing: true,
  llmText: vi.fn<(opts: Record<string, unknown>) => Promise<string>>(),
  claudeCreate: vi.fn<(params: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('../../textLlm.js', () => ({
  llmRoutingEnabled: () => h.routing,
  llmText: (opts: Record<string, unknown>) => h.llmText(opts),
  logLlmFallback: () => {},
}));
vi.mock('../../aiUsage.js', () => ({ trackedAnthropic: <T>(c: T) => c }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (p: Record<string, unknown>) => h.claudeCreate(p) };
  },
}));

import {
  verifyConversationMap, parseVerifierOutput, buildVerifierUserText, VERIFIER_VERSION, VERIFY_SYSTEM_PROMPT,
  type VerifyInput,
} from '../verifier.js';
import { CALL_TRANSCRIPT_RULES } from '../extractor.js';

const CHAT: VerifyInput = {
  conversation: {
    channel: 'chat', id: '966500000001@c.us',
    turns: [
      { speaker: 'agent', text: 'أي حي تفضّل؟', ref: 'm1' },
      { speaker: 'client', text: 'أبي النرجس، والعليا لا', ref: 'm2' },
    ],
  },
  mentions: [
    { evidence_id: 'ev-a', polarity: 'include', placed: 'حدّد: النرجس (الرياض)', on_map: true, mention_span: 'أبي النرجس' },
    { evidence_id: 'ev-b', polarity: 'exclude', placed: 'استبعد: العليا (الرياض)', on_map: true, mention_span: 'والعليا لا' },
  ],
};

const IDS = ['ev-a', 'ev-b'];
const claudeText = (text: string) => ({ content: [{ type: 'text', text }] });

let savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  delete process.env.WA_EXTRACT_STUB;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  h.routing = true;
  h.llmText.mockReset();
  h.claudeCreate.mockReset();
});
afterEach(() => { process.env = savedEnv; });

describe('verifier — stub mode', () => {
  it('stub mode agrees on every mention, deterministically, with no provider call', async () => {
    process.env.WA_EXTRACT_STUB = '1';
    const r = await verifyConversationMap(CHAT);
    expect(r).toEqual({
      status: 'ok', overall: 'agree', missed: [], model: 'stub',
      mentions: [
        { evidence_id: 'ev-a', verdict: 'right', reason: 'stub' },
        { evidence_id: 'ev-b', verdict: 'right', reason: 'stub' },
      ],
    });
    expect(h.llmText).not.toHaveBeenCalled();
    expect(h.claudeCreate).not.toHaveBeenCalled();
    expect(VERIFIER_VERSION).toBe('geo-verify/v1');
  });
});

describe('verifier — prompt', () => {
  it('shows the conversation as the extractor saw it, then each mention with its short id, span, placement and polarity', () => {
    const t = buildVerifierUserText(CHAT);
    expect(t).toContain('[1] المندوب: أي حي تفضّل؟');
    expect(t).toContain('[2] العميل: أبي النرجس، والعليا لا');
    expect(t).toContain('[m1] قال: «أبي النرجس» — وضع النظام على الخريطة: حدّد: النرجس (الرياض) (يريد)');
    expect(t).toContain('[m2] قال: «والعليا لا» — وضع النظام على الخريطة: استبعد: العليا (الرياض) (لا يريد)');
    expect(VERIFY_SYSTEM_PROMPT).toContain('أنت مراجعٌ صارم');
  });

  it('a call carries the same unlabelled-call rules the extractor uses; an unplaced mention has no polarity tag', () => {
    const t = buildVerifierUserText({
      conversation: { channel: 'call', id: 'call-1', turns: [{ speaker: 'unknown', text: 'عندنا مشروع في القروان. لا أنا أبي المهدية.' }] },
      mentions: [{ evidence_id: 'x', polarity: 'include', placed: 'لم يُوضع على الخريطة', on_map: false, mention_span: 'القروان' }],
    });
    expect(t).toContain(CALL_TRANSCRIPT_RULES);
    expect(t).toContain('[m1] قال: «القروان» — وضع النظام على الخريطة: لم يُوضع على الخريطة');
    expect(t.endsWith('لم يُوضع على الخريطة')).toBe(true);
  });
});

describe('verifier — parse + repair', () => {
  it('maps short ids back, keeps verdicts, and agrees only when every mention is right and nothing is missed', () => {
    const r = parseVerifierOutput(JSON.stringify({
      mentions: [{ id: 'm1', verdict: 'right', reason: 'قالها العميل' }, { id: 'm2', verdict: 'right', reason: 'رفضها صراحة' }],
      missed: [],
    }), IDS);
    expect(r).toEqual({
      overall: 'agree', missed: [],
      mentions: [
        { evidence_id: 'ev-a', verdict: 'right', reason: 'قالها العميل' },
        { evidence_id: 'ev-b', verdict: 'right', reason: 'رفضها صراحة' },
      ],
    });
  });

  it('unknown verdict → unsure; unknown id → dropped; omitted mention → unsure «لم يُراجَع»; raw evidence ids accepted', () => {
    const r = parseVerifierOutput('```json\n' + JSON.stringify({
      mentions: [
        { id: 'ev-a', verdict: 'totally_wrong', reason: 'x' },
        { id: 'm9', verdict: 'right', reason: 'not in the list' },
      ],
    }) + '\n```', IDS)!;
    expect(r.mentions).toEqual([
      { evidence_id: 'ev-a', verdict: 'unsure', reason: 'x' },
      { evidence_id: 'ev-b', verdict: 'unsure', reason: 'لم يُراجَع' },
    ]);
    expect(r.overall).toBe('doubt');
  });

  it('a missed place makes the overall a doubt even when every mention is right', () => {
    const r = parseVerifierOutput(JSON.stringify({
      mentions: [{ id: 'm1', verdict: 'right' }, { id: 'm2', verdict: 'right' }],
      missed: [{ span: 'الملقا', reason: 'قال العميل الملقا بعد' }, { span: '' }],
    }), IDS)!;
    expect(r.missed).toEqual([{ span: 'الملقا', reason: 'قال العميل الملقا بعد' }]);
    expect(r.overall).toBe('doubt');
  });

  it('off-map mentions: «not a preference / not a place» agrees with the system; «wrong polarity» means it belonged on the map', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const r = parseVerifierOutput(JSON.stringify({
      mentions: [
        { id: 'm1', verdict: 'not_a_preference', reason: 'اقتراح المندوب' },
        { id: 'm2', verdict: 'not_a_place', reason: 'اسم مشروع' },
        { id: 'm3', verdict: 'wrong_polarity', reason: 'العميل رفضه' },
        { id: 'm4', verdict: 'not_a_preference', reason: 'وُضع على الخريطة خطأ' },
      ],
      missed: [],
    }), ids, new Set(['a', 'b', 'c']))!;
    expect(r.mentions.map((m) => m.verdict)).toEqual(['right', 'right', 'wrong_place', 'not_a_preference']);
    expect(r.overall).toBe('doubt');
  });

  it('text that is not JSON parses to null (a failed call), never to agreement', () => {
    expect(parseVerifierOutput('I think it all looks fine', IDS)).toBeNull();
    expect(parseVerifierOutput('{not json}', IDS)).toBeNull();
    expect(parseVerifierOutput('[1,2]', IDS)).toBeNull();
  });
});

describe('verifier — provider routing', () => {
  it('DeepSeek primary, metered with track, JSON mode at temperature 0', async () => {
    h.llmText.mockResolvedValue(JSON.stringify({ mentions: [{ id: 'm1', verdict: 'right' }, { id: 'm2', verdict: 'wrong_polarity', reason: 'قال لا' }], missed: [] }));
    const r = await verifyConversationMap(CHAT);
    expect(r.status).toBe('ok');
    expect(r.overall).toBe('doubt');
    expect(r.model).toBe('deepseek-chat');
    expect(r.mentions[1]).toEqual({ evidence_id: 'ev-b', verdict: 'wrong_polarity', reason: 'قال لا' });
    const opts = h.llmText.mock.calls[0]![0];
    expect(opts).toMatchObject({ json: true, temperature: 0, track: { area: 'sales', callSite: 'api/_lib/geoPreference/verifier', operation: 'verify' } });
    expect(h.claudeCreate).not.toHaveBeenCalled();
  });

  it('DeepSeek non-JSON output falls back to Claude', async () => {
    h.llmText.mockResolvedValue('sorry');
    h.claudeCreate.mockResolvedValue(claudeText(JSON.stringify({ mentions: [{ id: 'm1', verdict: 'right' }, { id: 'm2', verdict: 'right' }], missed: [] })));
    const r = await verifyConversationMap(CHAT);
    expect(r).toMatchObject({ status: 'ok', overall: 'agree', model: 'claude-haiku-4-5-20251001' });
    expect(h.claudeCreate).toHaveBeenCalledTimes(1);
  });

  it('every provider failing → status error, overall unknown, NEVER agree, never throws', async () => {
    h.llmText.mockRejectedValue(new Error('deepseek 503'));
    h.claudeCreate.mockRejectedValue(new Error('anthropic 529 overloaded'));
    const r = await verifyConversationMap(CHAT);
    expect(r.status).toBe('error');
    expect(r.overall).toBe('unknown');
    expect(r.mentions).toEqual([]);
    expect(r.missed).toEqual([]);
    expect(r.error).toContain('deepseek 503');
    expect(r.error).toContain('anthropic 529 overloaded');
  });

  it('Claude-only (routing off) returning garbage → error / unknown', async () => {
    h.routing = false;
    h.claudeCreate.mockResolvedValue(claudeText('all good!'));
    const r = await verifyConversationMap(CHAT);
    expect(r).toMatchObject({ status: 'error', overall: 'unknown' });
    expect(h.llmText).not.toHaveBeenCalled();
  });

  it('an empty conversation is an error, not an agreement', async () => {
    const r = await verifyConversationMap({ ...CHAT, conversation: { channel: 'chat', turns: [] } });
    expect(r).toMatchObject({ status: 'error', overall: 'unknown' });
  });
});
