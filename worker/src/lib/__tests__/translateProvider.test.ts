/**
 * Link masking in the translation lane.
 *
 * The case these tests are built from is real: «ربوة الرمز» → project_analysis
 * carried a Supabase PDF link, the provider kept mangling it, the protected-fact
 * guard kept refusing the result, and the unit retried every 30 minutes from
 * 6 to 27 September — 1,232 calls that could never succeed.
 *
 * The guard is NOT relaxed here. The link is removed from what the model sees
 * and put back byte-identical afterwards, so the guard passes because the fact
 * genuinely survived. A model that DROPS a placeholder still fails.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  maskLinks, restoreLinks, assertFactsIntact, protectedFacts, translateItems, type TranslateItem,
} from '../translateProvider';
import { safeExcerpt } from '../../runTranslationJob';

const PDF = 'https://zhqqsxwealdwqzrbpwyv.supabase.co/storage/v1/object/public/marketing-assets/migrations/rabwat-alramz/masterplan-rabwat-alramz.pdf';
const AR = `مخطط المشروع متاح هنا (${PDF})، ويضم 120 وحدة سكنية.`;

describe('maskLinks / restoreLinks', () => {
  it('takes the link out and puts the same bytes back', () => {
    const { masked, links } = maskLinks(AR);
    expect(masked).not.toContain('https://');
    expect(masked).toContain('[[L0]]');
    expect(links).toEqual([PDF]);
    expect(restoreLinks(masked, links)).toEqual({ text: AR, missing: [] });
  });

  it('numbers several links independently', () => {
    const src = 'a https://x.test/1 b https://y.test/2 c';
    const { masked, links } = maskLinks(src);
    expect(masked).toBe('a [[L0]] b [[L1]] c');
    // The model reorders them into the target sentence — restoration is by id,
    // not by position, so a reordered sentence still resolves correctly.
    const out = restoreLinks('c [[L1]] b [[L0]] a', links);
    expect(out.text).toBe('c https://y.test/2 b https://x.test/1 a');
    expect(out.missing).toEqual([]);
  });

  it('tolerates a model that pads the brackets', () => {
    const { links } = maskLinks(AR);
    expect(restoreLinks('see [[ L0 ]] now', links).text).toBe(`see ${PDF} now`);
  });

  it('reports a DROPPED placeholder as a missing link', () => {
    const { links } = maskLinks(AR);
    const out = restoreLinks('the plan is available.', links);
    expect(out.missing).toEqual([PDF]);
  });

  it('leaves a placeholder we never issued visible instead of inventing a link', () => {
    const { links } = maskLinks('one https://x.test/1 link');
    const out = restoreLinks('[[L0]] and [[L7]]', links);
    expect(out.text).toBe('https://x.test/1 and [[L7]]');
    expect(out.missing).toEqual([]);
  });

  it('is a no-op for text without links', () => {
    const { masked, links } = maskLinks('لا يوجد رابط هنا');
    expect(masked).toBe('لا يوجد رابط هنا');
    expect(links).toEqual([]);
    expect(restoreLinks('no link here', links).text).toBe('no link here');
  });
});

// ---------------------------------------------------------------------------
// The excerpt that killed 1,014 jobs. Not a provider concern — it is the
// unit-upsert body — but it belongs with the other "what actually goes over the
// wire" tests.
// ---------------------------------------------------------------------------
describe('safeExcerpt', () => {
  const PIN = '\u{1F4CD}';                              // 📍 — ONE code point, TWO UTF-16 units
  const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

  it('never cuts an emoji in half', () => {
    const src = 'a'.repeat(199) + PIN + ' rest';
    // The naive slice ends on the high half of the pair. JSON.stringify emits
    // that as an unpaired escape and PostgREST answers "Empty or invalid json",
    // which threw and killed the whole record's job.
    expect(LONE_HIGH.test(src.slice(0, 200))).toBe(true);

    const safe = safeExcerpt(src, 200);
    expect(LONE_HIGH.test(safe)).toBe(false);
    expect(JSON.parse(JSON.stringify({ x: safe })).x).toBe(safe);
  });

  it('counts code points, so an emoji is taken whole or not at all', () => {
    expect(safeExcerpt(PIN + PIN + PIN, 2)).toBe(PIN + PIN);
  });

  it('keeps a valid surrogate pair intact (the regex must not eat the low half)', () => {
    expect(safeExcerpt(`موقع ${PIN} مميز`, 200)).toBe(`موقع ${PIN} مميز`);
  });

  it('drops a lone surrogate that was already in the source', () => {
    expect(safeExcerpt('ok\uD83Dbad', 50)).toBe('okbad');
  });

  it('drops NUL, which Postgres text cannot store', () => {
    expect(safeExcerpt('a\u0000b', 50)).toBe('ab');
  });

  it('leaves ordinary Arabic text alone', () => {
    expect(safeExcerpt('مخطط المشروع متاح هنا', 200)).toBe('مخطط المشروع متاح هنا');
  });
});

describe('the URL boundary', () => {
  it('does NOT swallow the punctuation after a link (the unsatisfiable-fact bug)', () => {
    // Before 2026-09-27 the fact was "…rabwat-alramz.pdf)،" — with the Arabic
    // comma — which no English sentence can contain. The field could not be
    // translated by any output at all.
    const facts = protectedFacts(AR);
    expect(facts).toContain(PDF);
    expect(facts.some((f) => f.endsWith(')،'))).toBe(false);
  });
  it('keeps punctuation that is genuinely part of the path', () => {
    expect(protectedFacts('see https://x.test/a_(draft)/p.pdf now')).toContain('https://x.test/a_(draft)/p.pdf');
  });
  it('leaves the sentence punctuation in the masked text for the model to translate', () => {
    const { masked } = maskLinks(AR);
    expect(masked).toContain('[[L0]])،');
  });
});

describe('assertFactsIntact still guards everything else', () => {
  it('catches a dropped number', () => {
    expect(assertFactsIntact('السعر 750,000 ريال', 'The price is riyals')).toEqual(['750,000']);
  });
  it('catches a mangled link when masking was NOT used', () => {
    expect(assertFactsIntact(AR, 'Plan: https://zhqqsxwealdwqzrbpwyv.supabase.co/…/masterplan.pdf, 120 units')).toContain(PDF);
  });
  it('passes when the restored text carries the link and the digits', () => {
    const restored = `The master plan is available here (${PDF}), with 120 residential units.`;
    expect(assertFactsIntact(AR, restored)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End to end through translateItems with a stubbed provider. This is the test
// that would have caught the live bug: the model mangles the link exactly the
// way DeepSeek did, and the item must STILL come back translated.
// ---------------------------------------------------------------------------

function stubDeepseek(reply: (src: string) => string) {
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const items = JSON.parse(body.messages[1]!.content.replace(/^Items:\n/, '')) as Array<{ i: number; src: string }>;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({ results: items.map((it) => ({ i: it.i, t: reply(it.src) })) }) },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: 'deepseek-flash',
      }),
      text: async () => '',
    } as unknown as Response;
  });
}

const item: TranslateItem = { id: 'u1', text: AR, treatment: 'translate', targetLang: 'en' };

afterEach(() => vi.unstubAllGlobals());

describe('translateItems with links', () => {
  it('survives a provider that would have mangled the URL', () => {
    // The model never sees the link, so it cannot break it. It echoes the
    // placeholder and "translates" around it.
    stubDeepseek((src) => src.replace('مخطط المشروع متاح هنا', 'The master plan is available here')
                             .replace('ويضم 120 وحدة سكنية', 'with 120 residential units'));
    return translateItems({ deepseekKey: 'k', anthropicKey: 'a' }, [item]).then((res) => {
      const r = res.get('u1')!;
      expect(r.error).toBeUndefined();
      expect(r.translated).toContain(PDF);
      expect(r.translated).toContain('120');
      expect(r.translated).not.toContain('[[L0]]');
    });
  });

  it('still FAILS when the model throws the link away', async () => {
    stubDeepseek(() => 'The master plan is available, with 120 residential units.');
    const res = await translateItems({ deepseekKey: 'k', anthropicKey: 'a' }, [item]);
    const r = res.get('u1')!;
    expect(r.translated).toBeUndefined();
    expect(r.error).toMatch(/protected link lost/);
    expect(r.error).toContain(PDF);
  });

  it('still FAILS when the model drops a number', async () => {
    stubDeepseek((src) => src.replace('120', 'several'));
    const res = await translateItems({ deepseekKey: 'k', anthropicKey: 'a' }, [item]);
    expect(res.get('u1')!.error).toMatch(/protected facts lost/);
  });
});
