import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  chunksToSegments, aggregateWords, normalizeFalResponse, transcribeAudioUrl, isMeaninglessTranscript, isAutoDetectMisfire, collapseRepeats,
  WORD_AGG_MAX_MS, WORD_AGG_MIN_MS,
} from '../falTranscribe';

// A fake fal response whose chunks come back OUT of chronological order — the
// shape the coordinator measured in stored rows ("text order looks scrambled").
const SCRAMBLED_SEGMENTS = {
  text: 'ثالث أول ثاني',
  languages: ['ar'],
  chunks: [
    { timestamp: [20.0, 28.5], text: 'ثالث' },
    { timestamp: [0.5, 9.9], text: 'أول' },
    { timestamp: [10.0, 19.9], text: 'ثاني' },
  ],
};

// 14 words over ~16 s with a clear pause after word 7 (t=7.1 → 8.4).
function wordChunks() {
  const words = ['بسم', 'الله', 'يا', 'متابعين', 'اليوم', 'في', 'مشروع.', 'الرياض', 'حي', 'الملقا', 'سعر', 'يبدأ', 'من', 'مليون'];
  const starts = [0.2, 0.7, 1.4, 1.9, 2.8, 3.5, 6.0, 8.4, 9.0, 9.6, 10.5, 11.2, 11.9, 15.0];
  return words.map((w, i) => ({ timestamp: [starts[i], starts[i] + 0.5] as [number, number], text: w }));
}

describe('chunksToSegments', () => {
  it('orders by start_ms and reports the reorder', () => {
    const { segments, reordered } = chunksToSegments(SCRAMBLED_SEGMENTS.chunks);
    expect(reordered).toBe(true);
    expect(segments.map((s) => s.text)).toEqual(['أول', 'ثاني', 'ثالث']);
    expect(segments[0]).toEqual({ start_ms: 500, end_ms: 9900, text: 'أول' });
  });
  it('keeps an already-ordered response untouched', () => {
    const { segments, reordered } = chunksToSegments([{ timestamp: [0, 1], text: 'a' }, { timestamp: [1, 2], text: 'b' }]);
    expect(reordered).toBe(false);
    expect(segments.map((s) => s.text)).toEqual(['a', 'b']);
  });
  it('drops empty chunks and tolerates null timestamps (fal schema allows them)', () => {
    const { segments } = chunksToSegments([
      { timestamp: [0, 2], text: 'a' },
      { timestamp: [2, 3], text: '   ' },
      { timestamp: [null, null], text: 'b' },
      { timestamp: [3, null], text: 'c' },
    ]);
    expect(segments).toEqual([
      { start_ms: 0, end_ms: 2000, text: 'a' },
      { start_ms: 3000, end_ms: 3000, text: 'b' },   // inherits the latest end seen (the dropped blank chunk still advanced it)
      { start_ms: 3000, end_ms: 3000, text: 'c' },   // null end collapses to start
    ]);
  });
});

describe('aggregateWords', () => {
  it('groups ordered words into ~5–8 s segments, closing at a pause once ≥ 5 s', () => {
    const { segments: words } = chunksToSegments(wordChunks());
    const agg = aggregateWords(words);
    expect(agg.length).toBeGreaterThanOrEqual(2);
    for (const s of agg) expect(s.end_ms - s.start_ms).toBeLessThanOrEqual(WORD_AGG_MAX_MS);
    // First segment: the greeting through the pause after "مشروع." (0.2 s → 6.5 s ≥ 5 s, gap 1.9 s).
    expect(agg[0].text).toBe('بسم الله يا متابعين اليوم في مشروع.');
    expect(agg[0].start_ms).toBe(200);
    expect(agg[0].end_ms).toBe(6500);
    expect(agg[0].end_ms - agg[0].start_ms).toBeGreaterThanOrEqual(WORD_AGG_MIN_MS);
    // Every word survives, in order, exactly once.
    expect(agg.map((s) => s.text).join(' ')).toBe(words.map((w) => w.text).join(' '));
  });
  it('never exceeds the max span even without pauses', () => {
    const dense = Array.from({ length: 40 }, (_, i) => ({ start_ms: i * 400, end_ms: i * 400 + 300, text: `w${i}` }));
    const agg = aggregateWords(dense);
    for (const s of agg) expect(s.end_ms - s.start_ms).toBeLessThanOrEqual(WORD_AGG_MAX_MS);
    expect(agg.flatMap((s) => s.text.split(' '))).toHaveLength(40);
  });
});

describe('normalizeFalResponse', () => {
  it('rebuilds text from sorted segments only when the response was scrambled', () => {
    const r = normalizeFalResponse(SCRAMBLED_SEGMENTS, 30000, 'fal-ai/wizper', { language: 'ar' }, 'segment');
    expect(r.text).toBe('أول ثاني ثالث');
    expect(r.language).toBe('ar');
    expect(r.costUsd).toBe(0.005);
    const ordered = normalizeFalResponse({ text: 'a  b', chunks: [{ timestamp: [0, 1], text: 'a' }, { timestamp: [1, 2], text: 'b' }] }, 6000, 'm', {}, 'segment');
    expect(ordered.text).toBe('a  b'); // verbatim — default behaviour preserved
  });
  it('word mode aggregates and keeps the word list in raw', () => {
    const r = normalizeFalResponse({ text: 'x', chunks: wordChunks(), languages: ['ar'] }, null, 'fal-ai/whisper', { chunk_level: 'word' }, 'word');
    expect(r.segments.length).toBeLessThan(wordChunks().length);
    expect((r.raw as { chunks: unknown[] }).chunks).toHaveLength(14);
    expect((r.raw as { _request: { chunk_level: string } })._request.chunk_level).toBe('word');
  });
  it('estimates cost from the last timestamp when durationMs is null, and warns when it cannot', () => {
    const r = normalizeFalResponse({ text: 'كلام', chunks: [{ timestamp: [0, 90], text: 'كلام' }] }, null, 'm', {}, 'segment');
    expect(r.costUsd).toBe(0.015); // 1.5 min × $0.01
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const z = normalizeFalResponse({ text: 'كلام', chunks: [] }, null, 'm', {}, 'segment');
    expect(z.costUsd).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it('keeps the meaningless-transcript guard', () => {
    const r = normalizeFalResponse({ text: 'you', chunks: [{ timestamp: [1.3, 4.7], text: 'you' }] }, 9493, 'm', {}, 'segment');
    expect(r).toMatchObject({ text: '', segments: [], language: 'none' });
    expect(r.costUsd).toBe(0.0016);
  });
  it('treats bare music notes as no speech', () => {
    for (const t of ['♪♪ ♪♪', '♪♪ ♪♪ ♪♪', '♫']) expect(isMeaninglessTranscript(t)).toBe(true);
    expect(isMeaninglessTranscript('♪ مشروع يمام بارك ♪')).toBe(false);
    expect(isMeaninglessTranscript('*Splash*')).toBe(true);
    expect(isMeaninglessTranscript('[music] ')).toBe(true);
  });
  it('Arabic "music / subscribe" hallucinations alone are no speech; inside real speech they stay', () => {
    expect(isMeaninglessTranscript('موسيقى اشتركوا في القناة')).toBe(true);
    expect(isMeaninglessTranscript('ترجمة نانسي قنقر')).toBe(true);
    expect(isMeaninglessTranscript('موسيقى هادئة في مشروع الماجدية 155 بحي عرقة')).toBe(false);
  });
  it('collapses decoder loops but keeps genuine repeats', () => {
    expect(collapseRepeats('ماذا عنك؟ ماذا عنك؟ ماذا عنك؟ رجل')).toBe('ماذا عنك؟ ماذا عنك؟ ماذا عنك؟ رجل');
    expect(collapseRepeats('قبل ' + 'لا '.repeat(300) + 'بعد')).toBe('قبل لا بعد');
    expect(collapseRepeats('ب ' + 'و تفتح الجانب المفتاحي على النافذة '.repeat(25) + 'ج')).toBe('ب و تفتح الجانب المفتاحي على النافذة ج');
    expect(collapseRepeats('مرتب اه' + 'ه'.repeat(400) + ' دورة')).toBe('مرتب اههه دورة');
    const plain = 'مشروع  وكن 45\nفي حي النسيم';
    expect(collapseRepeats(plain)).toBe(plain); // untouched, whitespace included
  });
  it('an auto-detect that lands outside ar/en is music, not speech', () => {
    // Real rows from the 2026-09-29 backfill batch.
    const km = normalizeFalResponse({ text: 'សូវតានប់ពីបានប់ពី', chunks: [{ timestamp: [0, 35], text: 'សូវតានប់ពីបានប់ពី' }], languages: ['km'] }, 35000, 'fal-ai/wizper', { language: null }, 'segment');
    expect(km).toMatchObject({ text: '', language: 'none' });
    const la = normalizeFalResponse({ text: 'I am a man of the mind.', chunks: [], languages: ['la'] }, 63000, 'fal-ai/wizper', { language: null }, 'segment');
    expect(la.language).toBe('none');
    expect(isAutoDetectMisfire({ language: null }, ['ar'])).toBe(false);
    expect(isAutoDetectMisfire({ language: null }, ['en'])).toBe(false);
    // A forced language is the caller's decision, never overridden.
    expect(isAutoDetectMisfire({ language: 'ar' }, ['km'])).toBe(false);
  });
});

describe('transcribeAudioUrl request shape', () => {
  const bodies: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    process.env.FAL_KEY = 'test-key';
    bodies.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ status_url: 'https://q/status', response_url: 'https://q/resp' }), { status: 200 });
      }
      if (url === 'https://q/status') return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
      return new Response(JSON.stringify(SCRAMBLED_SEGMENTS), { status: 200 });
    }));
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  // `track` is required on every real call (it decides which feature the spend
  // is attributed to); these tests are about the REQUEST SHAPE, so they pin a
  // fixed ref and vary only the transport knobs.
  const TRACK = { area: 'competitors', callSite: 'test', operation: 'transcribe' } as const;

  async function call(opts?: Omit<Parameters<typeof transcribeAudioUrl>[2], 'track'>) {
    const p = transcribeAudioUrl('https://x/a.m4a', 30000, { ...TRACK, ...(opts ?? {}) });
    await vi.advanceTimersByTimeAsync(3100);
    return p;
  }

  it('with no options sends language: null (auto-detect) — never omits the key', async () => {
    // Omitting the key = fal's default "en" = Saudi Arabic translated into
    // English (840 competitor rows, 2026-07-23 → 2026-09-28). Pin it.
    const r = await call();
    expect(bodies[0]).toEqual({ audio_url: 'https://x/a.m4a', task: 'transcribe', chunk_level: 'segment', version: '3', language: null });
    expect(r.segments.map((s) => s.text)).toEqual(['أول', 'ثاني', 'ثالث']);
  });
  it('passes language ar / explicit null / segment tuning through', async () => {
    await call({ language: 'ar', maxSegmentLen: 10, mergeChunks: false });
    expect(bodies[0]).toMatchObject({ language: 'ar', max_segment_len: 10, merge_chunks: false });
    await call({ language: null });
    expect(bodies[1]).toHaveProperty('language', null);
  });
  it('refuses word-level on wizper before any network call', async () => {
    await expect(transcribeAudioUrl('https://x/a.m4a', 1000, { chunkLevel: 'word' })).rejects.toThrow(/only supports chunk_level 'segment'/);
    expect(bodies).toHaveLength(0);
  });
  it('sends word-level to an overridden model', async () => {
    await call({ chunkLevel: 'word', model: 'fal-ai/whisper', language: 'ar' });
    expect(bodies[0]).toMatchObject({ chunk_level: 'word', language: 'ar' });
    expect((fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/whisper');
  });
});
